<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, ref, watch } from 'vue';
import { errorMessage } from '../errors';
import { plain } from '../plain';
import {
  ALL_SOURCES,
  type ColumnKind,
  type DataSource,
  type TableKind,
  type TableSchema,
  type TransformedTable,
} from '../shared/types';
import { projectChanged } from '../ui-signals';
import RunningTimer from './RunningTimer.vue';
import TransformEditor from './TransformEditor.vue';

defineEmits<{ addData: [] }>();

type Point = { x: number; y: number };

// Layout for tables that haven't been placed yet: a grid of cards.
const CARD_WIDTH = 240;
const GRID_GAP = 48;
const GRID_ROW_HEIGHT = 400;
const GRID_COLUMNS = 4;
const GRID_ORIGIN: Point = { x: 48, y: 120 };
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 1.6;

const tables = ref<TableSchema[]>([]);
const sources = ref<DataSource[]>([]);
/** Transformed tables' definitions, by name. */
const definitions = ref<Record<string, TransformedTable>>({});
const loading = ref(true);
const error = ref('');

const positions = ref<Record<string, Point>>({});
/** Draw order: the last table is on top. */
const stacking = ref<string[]>([]);
const pan = ref<Point>({ x: 0, y: 0 });
const zoom = ref(1);

const viewport = ref<HTMLElement | null>(null);
const cardElements = new Map<string, HTMLElement>();

async function load() {
  error.value = '';
  try {
    const [schemas, sourceList, diagram, transformed] = await Promise.all([
      window.api.data.describeTables(),
      window.api.data.listSources(),
      window.api.data.loadDiagram(),
      window.api.data.listTransformed(),
    ]);
    definitions.value = Object.fromEntries(transformed.map((t) => [t.name, t]));
    // A transformed table whose build failed has no data, but still gets a card.
    const built = new Set(schemas.map((s) => s.name));
    tables.value = [
      ...schemas,
      ...transformed
        .filter((t) => !built.has(t.name))
        .map(
          (t): TableSchema => ({
            name: t.name,
            kind: 'transformed',
            rows: 0,
            columns: [],
            transformed: false,
          }),
        ),
    ];
    sources.value = sourceList;
    positions.value = { ...diagram.tables };
    placeNewTables();
    stacking.value = tables.value.map((t) => t.name);
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}

// Kept alive between workflow steps, so reload whenever the screen is shown: data may have
// been added or refreshed in the meantime.
// onActivated also fires on the first show, so this loads once, not twice.
onActivated(load);
// The assistant changed the project (or a change was undone).
watch(projectChanged, load);

// --- Refreshing every data source ---------------------------------------------------------------

const refreshing = ref(false);
const refreshStatus = ref('');
// True once a source's data has arrived: Refresh all then runs to the end.
const refreshReceived = ref(false);
const refreshResult = ref<{ ok: boolean; message: string } | null>(null);

const unsubscribeProgress = window.api.data.onProgress((p) => {
  if (refreshing.value && p.sourceId === ALL_SOURCES) {
    refreshStatus.value = p.message;
    refreshReceived.value = p.received === true;
  }
});
onBeforeUnmount(unsubscribeProgress);

/**
 * Reloads every data source, then re-applies transforms and rebuilds transformed tables in
 * dependency order, then the cards.
 */
async function refreshAll() {
  if (refreshing.value) return;
  refreshing.value = true;
  refreshResult.value = null;
  refreshStatus.value = 'Starting…';
  refreshReceived.value = false;
  try {
    const result = await window.api.data.refreshAll();
    const problems = [
      ...result.failedSources.map((s) => `${s.name}: ${s.error}`),
      ...result.failedTables.map((t) => `${t.name}: ${t.error}`),
    ];
    const count = `${result.sourceCount} ${result.sourceCount === 1 ? 'data source' : 'data sources'}`;
    refreshResult.value = problems.length
      ? {
          ok: false,
          message: `Refreshed ${count}, with problems. ${problems.join(' ')}`,
        }
      : { ok: true, message: `Refreshed ${count} and rebuilt every table.` };
  } catch (err) {
    refreshResult.value = { ok: false, message: errorMessage(err) };
  } finally {
    refreshing.value = false;
    await load();
  }
}

/** Stops Refresh all. Its call then fails with "Stopped.". */
const stopRefreshAll = () => window.api.data.stop(ALL_SOURCES);

/** Puts tables without a saved position in a grid below the ones that have one. */
function placeNewTables() {
  const placed = tables.value.filter((t) => positions.value[t.name]);
  const unplaced = tables.value.filter((t) => !positions.value[t.name]);
  const top = placed.length
    ? Math.max(...placed.map((t) => positions.value[t.name].y)) +
      GRID_ROW_HEIGHT
    : GRID_ORIGIN.y;
  unplaced.forEach((t, i) => {
    positions.value[t.name] = {
      x: GRID_ORIGIN.x + (i % GRID_COLUMNS) * (CARD_WIDTH + GRID_GAP),
      y: top + Math.floor(i / GRID_COLUMNS) * GRID_ROW_HEIGHT,
    };
  });
}

async function saveLayout() {
  const layout = Object.fromEntries(
    tables.value.map((t) => [t.name, positions.value[t.name]]),
  );
  try {
    await window.api.data.saveDiagram(plain({ tables: layout }));
  } catch (err) {
    error.value = errorMessage(err);
  }
}

// --- Table actions ------------------------------------------------------------------------------

/** The SQL open in the editor: a loaded table's in-place transform, or a transformed table
 * (table null for a new one). */
const editing = ref<{ table: string | null; kind: TableKind } | null>(null);
const confirmingDelete = ref<string | null>(null);
/** Why a table couldn't be deleted, shown on its card. */
const deleteErrors = ref<Record<string, string>>({});

async function deleteTable(table: string) {
  confirmingDelete.value = null;
  try {
    await window.api.data.deleteTable(table);
    await load();
  } catch (err) {
    deleteErrors.value = { ...deleteErrors.value, [table]: errorMessage(err) };
  }
}

function askToDelete(table: string) {
  const { [table]: _, ...others } = deleteErrors.value;
  deleteErrors.value = others;
  confirmingDelete.value = table;
}

/** The editor's key, so creating a table and then editing another starts afresh. */
const editorKey = computed(() =>
  editing.value ? `${editing.value.kind}:${editing.value.table ?? '+new'}` : '',
);

function tidyUp() {
  positions.value = {};
  placeNewTables();
  saveLayout();
  fitToScreen();
}

// --- Dragging tables and panning ------------------------------------------------------------

type Drag =
  | {
      kind: 'table';
      table: string;
      start: Point;
      origin: Point;
      moved: boolean;
    }
  | { kind: 'pan'; start: Point; origin: Point };
const drag = ref<Drag | null>(null);

function bringToFront(table: string) {
  stacking.value = [...stacking.value.filter((t) => t !== table), table];
}

function startTableDrag(event: PointerEvent, table: string) {
  if (event.button !== 0) return;
  event.preventDefault();
  bringToFront(table);
  drag.value = {
    kind: 'table',
    table,
    start: { x: event.clientX, y: event.clientY },
    origin: { ...positions.value[table] },
    moved: false,
  };
  listenForDrag();
}

function startPan(event: PointerEvent) {
  // Left or middle button on the empty canvas.
  if (event.button !== 0 && event.button !== 1) return;
  event.preventDefault();
  drag.value = {
    kind: 'pan',
    start: { x: event.clientX, y: event.clientY },
    origin: { ...pan.value },
  };
  listenForDrag();
}

function onDragMove(event: PointerEvent) {
  const d = drag.value;
  if (!d) return;
  const dx = event.clientX - d.start.x;
  const dy = event.clientY - d.start.y;
  if (d.kind === 'table') {
    d.moved ||= Math.abs(dx) + Math.abs(dy) > 2;
    positions.value[d.table] = {
      x: Math.round(d.origin.x + dx / zoom.value),
      y: Math.round(d.origin.y + dy / zoom.value),
    };
  } else {
    pan.value = { x: d.origin.x + dx, y: d.origin.y + dy };
  }
}

function onDragEnd() {
  const d = drag.value;
  drag.value = null;
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  if (d?.kind === 'table' && d.moved) saveLayout();
}

function listenForDrag() {
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
}

onBeforeUnmount(onDragEnd);

// --- Zoom ----------------------------------------------------------------------------------------

const clampZoom = (value: number) =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

/** Zooms keeping the canvas point under (clientX, clientY) in place. */
function zoomAt(clientX: number, clientY: number, nextZoom: number) {
  const rect = viewport.value!.getBoundingClientRect();
  const screen = { x: clientX - rect.left, y: clientY - rect.top };
  const world = {
    x: (screen.x - pan.value.x) / zoom.value,
    y: (screen.y - pan.value.y) / zoom.value,
  };
  zoom.value = clampZoom(nextZoom);
  pan.value = {
    x: screen.x - world.x * zoom.value,
    y: screen.y - world.y * zoom.value,
  };
}

function zoomBy(factor: number) {
  const rect = viewport.value!.getBoundingClientRect();
  zoomAt(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
    zoom.value * factor,
  );
}

function onWheel(event: WheelEvent) {
  // Let a table's column list scroll when the pointer is over it.
  const list = (event.target as Element).closest('.columns');
  if (!event.ctrlKey && list && list.scrollHeight > list.clientHeight) return;
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) {
    zoomAt(
      event.clientX,
      event.clientY,
      zoom.value * Math.exp(-event.deltaY * 0.002),
    );
  } else {
    pan.value = {
      x: pan.value.x - event.deltaX,
      y: pan.value.y - event.deltaY,
    };
  }
}

/** Zooms and pans so every table is visible. */
function fitToScreen() {
  if (!viewport.value || tables.value.length === 0) return;
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const t of tables.value) {
    const box = cardBox(t.name);
    if (!box) continue;
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.w);
    bottom = Math.max(bottom, box.y + box.h);
  }
  const padding = 48;
  const { clientWidth, clientHeight } = viewport.value;
  zoom.value = clampZoom(
    Math.min(
      1,
      (clientWidth - padding * 2) / (right - left),
      (clientHeight - padding * 2 - 60) / (bottom - top),
    ),
  );
  pan.value = {
    x: (clientWidth - (right - left) * zoom.value) / 2 - left * zoom.value,
    y:
      60 +
      (clientHeight - 60 - (bottom - top) * zoom.value) / 2 -
      top * zoom.value,
  };
}

// --- Display ----------------------------------------------------------------------------------

const sourceByTable = computed(() => {
  const map = new Map<string, string>();
  for (const s of sources.value) for (const t of s.tables) map.set(t, s.name);
  return map;
});

/** dlt splits nested data into child tables named parent__child. */
const parentOf = (table: string) =>
  table.includes('__') ? table.slice(0, table.lastIndexOf('__')) : null;

const BADGES: Record<ColumnKind, { label: string; title: string }> = {
  integer: { label: '123', title: 'Whole number' },
  decimal: { label: '1.2', title: 'Decimal number' },
  text: { label: 'Abc', title: 'Text' },
  boolean: { label: 'T/F', title: 'True or false' },
  date: { label: 'Date', title: 'Date' },
  datetime: { label: 'Time', title: 'Date and time' },
  time: { label: 'Time', title: 'Time of day' },
  nested: { label: '{ }', title: 'Nested data' },
  other: { label: '?', title: 'Other' },
};

const totalColumns = computed(() =>
  tables.value.reduce((sum, t) => sum + t.columns.length, 0),
);

// Card heights vary (column lists, error messages), and dependency lines attach to card edges,
// so track each card's height as it renders and changes.
const cardHeights = ref<Record<string, number>>({});
const resizeObserver = new ResizeObserver((entries) => {
  const next = { ...cardHeights.value };
  for (const entry of entries) {
    const element = entry.target as HTMLElement;
    if (element.dataset.table)
      next[element.dataset.table] = element.offsetHeight;
  }
  cardHeights.value = next;
});
onBeforeUnmount(() => resizeObserver.disconnect());

function setCardElement(table: string, element: unknown) {
  const previous = cardElements.get(table);
  if (previous && previous !== element) resizeObserver.unobserve(previous);
  if (element instanceof HTMLElement) {
    cardElements.set(table, element);
    resizeObserver.observe(element);
  } else {
    cardElements.delete(table);
  }
}

// --- Dependency lines ------------------------------------------------------------------------------

type Box = { x: number; y: number; w: number; h: number };

function cardBox(table: string): Box | null {
  const position = positions.value[table];
  if (!position) return null;
  return { ...position, w: CARD_WIDTH, h: cardHeights.value[table] ?? 300 };
}

/**
 * A curve from one card's edge to another's: bottom to top when one card is clearly above the
 * other, otherwise side to side.
 */
function linkPath(from: Box, to: Box): string {
  const fromCenter = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const toCenter = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  const verticalGap = Math.max(
    to.y - (from.y + from.h),
    from.y - (to.y + to.h),
  );
  const horizontalGap = Math.max(
    to.x - (from.x + from.w),
    from.x - (to.x + to.w),
  );

  let start, end, c1, c2;
  if (verticalGap > 0 && verticalGap >= horizontalGap) {
    const down = toCenter.y > fromCenter.y;
    start = { x: fromCenter.x, y: down ? from.y + from.h : from.y };
    end = { x: toCenter.x, y: down ? to.y : to.y + to.h };
    const bend = Math.max(40, Math.abs(end.y - start.y) / 2) * (down ? 1 : -1);
    c1 = { x: start.x, y: start.y + bend };
    c2 = { x: end.x, y: end.y - bend };
  } else {
    const right = toCenter.x > fromCenter.x;
    // Attach near the top of the cards, beside their names, rather than mid-way down long cards.
    start = {
      x: right ? from.x + from.w : from.x,
      y: from.y + Math.min(from.h / 2, 40),
    };
    end = { x: right ? to.x : to.x + to.w, y: to.y + Math.min(to.h / 2, 40) };
    const bend = Math.max(40, Math.abs(end.x - start.x) / 2) * (right ? 1 : -1);
    c1 = { x: start.x + bend, y: start.y };
    c2 = { x: end.x - bend, y: end.y };
  }
  return `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;
}

/** One line per table a transformed table reads, for tables that are on the canvas. */
const links = computed(() =>
  tables.value
    .filter((t) => t.kind === 'transformed')
    .flatMap((t) =>
      (definitions.value[t.name]?.dependsOn ?? []).flatMap((source) => {
        const from = cardBox(source);
        const to = cardBox(t.name);
        return from && to
          ? [
              {
                key: `${source}>${t.name}`,
                from: source,
                to: t.name,
                path: linkPath(from, to),
              },
            ]
          : [];
      }),
    ),
);

/** The table under the pointer: its lines are highlighted and the others faded. */
const hoveredTable = ref<string | null>(null);
const showLegend = ref(true);
</script>

<template>
  <div class="model">
    <TransformEditor
      v-if="editing"
      :key="editorKey"
      :table="editing.table"
      :kind="editing.kind"
      :tables="tables"
      @back="editing = null"
      @changed="load"
    />

    <template v-else>
      <p v-if="error" class="box-error error" role="alert">{{ error }}</p>

      <div v-if="loading" class="centered status">Loading tables…</div>

      <div v-else-if="tables.length === 0 && !error" class="centered empty">
        <div class="empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M3 4h7v6H3zM14 14h7v6h-7zM6.5 10v4a3 3 0 0 0 3 3H14" />
          </svg>
        </div>
        <h3>No tables yet</h3>
        <p>
          Add data first. Each table you load will appear here with its columns.
        </p>
        <button class="btn-primary add-data" @click="$emit('addData')">
          Add data
        </button>
      </div>

      <div
        v-else
        ref="viewport"
        class="viewport"
        :class="{
          panning: drag?.kind === 'pan',
          dragging: drag?.kind === 'table',
        }"
        :style="{
          backgroundPosition: `${pan.x}px ${pan.y}px`,
          backgroundSize: `${20 * zoom}px ${20 * zoom}px`,
        }"
        @pointerdown="startPan"
        @wheel="onWheel"
      >
        <div
          class="world"
          :style="{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }"
        >
          <!-- Dependency lines between tables, underneath the cards, in the same coordinates as
             the cards' positions. -->
          <svg class="links" aria-hidden="true">
            <defs>
              <marker
                id="link-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            </defs>
            <path
              v-for="link in links"
              :key="link.key"
              :d="link.path"
              class="link"
              :class="{
                active: hoveredTable === link.from || hoveredTable === link.to,
                faded:
                  hoveredTable !== null &&
                  hoveredTable !== link.from &&
                  hoveredTable !== link.to,
              }"
              marker-end="url(#link-arrow)"
            />
          </svg>

          <article
            v-for="t in tables"
            :key="t.name"
            :ref="(el) => setCardElement(t.name, el)"
            class="table-card"
            :class="{ transformed: t.kind === 'transformed' }"
            :data-table="t.name"
            :style="{
              left: `${positions[t.name]?.x ?? 0}px`,
              top: `${positions[t.name]?.y ?? 0}px`,
              width: `${CARD_WIDTH}px`,
              zIndex: stacking.indexOf(t.name) + 1,
            }"
            @pointerdown.stop="bringToFront(t.name)"
            @pointerenter="hoveredTable = t.name"
            @pointerleave="hoveredTable = null"
          >
            <header
              class="card-head"
              title="Drag to move"
              @pointerdown="startTableDrag($event, t.name)"
            >
              <h3 :title="t.name">{{ t.name }}</h3>
              <small v-if="t.kind === 'transformed'">
                Transformed
                <template v-if="definitions[t.name]?.dependsOn.length">
                  from {{ definitions[t.name].dependsOn.join(', ') }}
                </template>
                · {{ t.rows.toLocaleString() }} rows
              </small>
              <small v-else>
                <template v-if="parentOf(t.name)"
                  >Nested in {{ parentOf(t.name) }}</template
                >
                <template v-else>{{
                  sourceByTable.get(t.name) ?? 'Unknown source'
                }}</template>
                · {{ t.rows.toLocaleString() }} rows
              </small>
            </header>
            <div class="card-tools">
              <template v-if="confirmingDelete === t.name">
                <span
                  class="confirm-text"
                  :title="
                    t.kind === 'loaded'
                      ? 'Refreshing its data source will load it again'
                      : undefined
                  "
                  >Delete this table?</span
                >
                <button class="tool danger-solid" @click="deleteTable(t.name)">
                  Delete
                </button>
                <button class="tool" @click="confirmingDelete = null">
                  Cancel
                </button>
              </template>
              <template v-else>
                <button
                  v-if="t.kind === 'transformed'"
                  class="tool"
                  title="Edit the SQL that builds this table"
                  @click="editing = { table: t.name, kind: 'transformed' }"
                >
                  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M8 6l-6 6 6 6M16 6l6 6-6 6" />
                  </svg>
                  Edit SQL
                </button>
                <button
                  v-else
                  class="tool"
                  :class="{ active: t.transformed }"
                  :title="
                    t.transformed
                      ? 'A SQL transform is active. Click to edit it.'
                      : 'Transform this table with SQL'
                  "
                  @click="editing = { table: t.name, kind: 'loaded' }"
                >
                  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M8 6l-6 6 6 6M16 6l6 6-6 6" />
                  </svg>
                  {{ t.transformed ? 'Transformed' : 'Transform' }}
                </button>
                <button
                  class="tool delete"
                  title="Delete this table"
                  @click="askToDelete(t.name)"
                >
                  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"
                    />
                  </svg>
                  Delete
                </button>
              </template>
            </div>
            <p v-if="deleteErrors[t.name]" class="card-error" role="alert">
              {{ deleteErrors[t.name] }}
            </p>
            <p
              v-if="t.kind === 'transformed' && definitions[t.name]?.error"
              class="card-error"
              role="alert"
            >
              Couldn't build this table: {{ definitions[t.name].error }}
            </p>
            <ul class="columns" :aria-label="`Columns in ${t.name}`">
              <li
                v-for="c in t.columns"
                :key="c.name"
                :data-column="c.name"
                :title="`${c.name} (${c.type})`"
              >
                <span
                  class="badge"
                  :class="c.kind"
                  :title="BADGES[c.kind].title"
                  >{{ BADGES[c.kind].label }}</span
                >
                <span class="column-name">{{ c.name }}</span>
              </li>
            </ul>
            <footer class="card-foot">
              {{ t.columns.length }}
              {{ t.columns.length === 1 ? 'column' : 'columns' }}
            </footer>
          </article>
        </div>

        <header class="overlay title" @pointerdown.stop>
          <h2>Model data</h2>
          <p>
            {{ tables.length }} {{ tables.length === 1 ? 'table' : 'tables' }} ·
            {{ totalColumns }} columns
          </p>
        </header>

        <div class="overlay refresh-area" @pointerdown.stop>
          <div class="top-actions">
            <button
              class="refresh new-table"
              title="Create a table from other tables with SQL"
              @click="editing = { table: null, kind: 'transformed' }"
            >
              <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              New transformed table
            </button>
            <button
              class="refresh"
              :disabled="refreshing"
              title="Reload the data from every data source"
              @click="refreshAll"
            >
              <svg
                class="icon"
                viewBox="0 0 24 24"
                aria-hidden="true"
                :class="{ spinning: refreshing }"
              >
                <path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5" />
              </svg>
              {{ refreshing ? 'Refreshing…' : 'Refresh all data' }}
            </button>
          </div>
          <p v-if="refreshing" class="refresh-status" aria-live="polite">
            {{ refreshStatus }}
            <RunningTimer
              class="timer"
              :can-stop="!refreshReceived"
              @stop="stopRefreshAll"
            />
          </p>
          <p
            v-else-if="refreshResult"
            class="refresh-result"
            :class="{ failed: !refreshResult.ok }"
            role="status"
          >
            {{ refreshResult.message }}
            <button
              class="dismiss"
              aria-label="Dismiss"
              @click="refreshResult = null"
            >
              ×
            </button>
          </p>
        </div>

        <div
          class="overlay toolbar"
          role="toolbar"
          aria-label="Canvas"
          @pointerdown.stop
        >
          <button
            title="Zoom out"
            aria-label="Zoom out"
            @click="zoomBy(1 / 1.2)"
          >
            −
          </button>
          <span class="zoom-level">{{ Math.round(zoom * 100) }}%</span>
          <button title="Zoom in" aria-label="Zoom in" @click="zoomBy(1.2)">
            +
          </button>
          <span class="sep" aria-hidden="true"></span>
          <button title="Show all tables" @click="fitToScreen">Fit</button>
          <button title="Arrange tables in a grid" @click="tidyUp">
            Tidy up
          </button>
        </div>

        <aside
          v-if="showLegend"
          class="overlay legend"
          aria-label="Legend"
          @pointerdown.stop
        >
          <header class="legend-head">
            <strong>Legend</strong>
            <button
              class="dismiss"
              aria-label="Hide legend"
              title="Hide legend"
              @click="showLegend = false"
            >
              ×
            </button>
          </header>
          <ul>
            <li><span class="swatch loaded"></span>Loaded table</li>
            <li><span class="swatch transformed"></span>Transformed table</li>
          </ul>
        </aside>
        <button
          v-else
          class="overlay legend-show"
          @pointerdown.stop
          @click="showLegend = true"
        >
          Show legend
        </button>

        <p class="overlay hint" @pointerdown.stop>
          Drag tables by their name · drag the background to pan · Ctrl + scroll
          to zoom
        </p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.timer {
  margin-left: 8px;
}

.model {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
}

.viewport {
  position: relative;
  flex: 1;
  overflow: hidden;
  background-image: radial-gradient(var(--border) 1px, transparent 1px);
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.viewport.panning {
  cursor: grabbing;
}

.world {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
}

.links {
  position: absolute;
  top: 0;
  left: 0;
  overflow: visible;
  pointer-events: none;
}

.link {
  fill: none;
  stroke: var(--transformed);
  stroke-width: 2;
  opacity: 0.55;
  transition:
    opacity 0.15s,
    stroke-width 0.15s;
}

.link.active {
  stroke-width: 3;
  opacity: 1;
}

.link.faded {
  opacity: 0.15;
}

#link-arrow path {
  fill: var(--transformed);
}

.legend {
  bottom: 52px;
  left: 36px;
  width: 230px;
  padding: 10px 12px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  font-size: 12px;
}

.legend-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.legend ul {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.legend li {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ink-muted);
}

.swatch {
  flex: none;
  width: 22px;
  height: 14px;
  border: 1px solid var(--border);
  border-top: 4px solid var(--accent);
  border-radius: 3px;
  background: var(--surface);
}

.swatch.transformed {
  border-top-color: var(--transformed);
}

.legend-show {
  bottom: 52px;
  left: 36px;
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--ink-muted);
  font-size: 12px;
  font-weight: 600;
}

.table-card {
  position: absolute;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  cursor: default;
  transition: box-shadow 0.15s;
}

.table-card:hover {
  box-shadow: var(--shadow-md);
}

.card-head {
  padding: 12px 14px 10px;
  border-top: 3px solid var(--accent);
  border-bottom: 1px solid var(--border);
  cursor: grab;
}

.viewport.dragging .card-head {
  cursor: grabbing;
}

.card-head h3 {
  overflow: hidden;
  font-size: 15px;
  font-weight: var(--display-weight);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.card-head small {
  display: block;
  margin-top: 2px;
  overflow: hidden;
  color: var(--ink-muted);
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.card-tools {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 38px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}

.tool {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--ink-muted);
  font-size: 12px;
  font-weight: 600;
}

.tool:hover {
  background: var(--surface-muted);
  color: var(--ink);
}

.tool .icon {
  width: 14px;
  height: 14px;
}

.tool.delete {
  margin-left: auto;
}

.tool.delete:hover {
  background: var(--danger-soft);
  color: var(--danger);
}

.tool.danger-solid {
  margin-left: auto;
  background: var(--danger);
  color: var(--surface);
}

.confirm-text {
  padding-left: 4px;
  color: var(--ink);
  font-size: 12px;
  font-weight: 600;
}

/* A transform is active on this table. */
.tool.active,
.tool.active:hover {
  background: var(--success-soft);
  color: var(--success);
}

.columns {
  max-height: 260px;
  margin: 0;
  padding: 6px;
  overflow-y: auto;
  list-style: none;
}

.columns li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  font-size: 13px;
}

.columns li:hover {
  background: var(--surface-muted);
}

.column-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.badge {
  flex: none;
  width: 34px;
  padding: 1px 0;
  border-radius: 4px;
  background: var(--surface-muted);
  color: var(--ink-muted);
  font-size: 10px;
  font-weight: 600;
  text-align: center;
}

.badge.integer,
.badge.decimal {
  background: #e3e8f0;
  color: #3b5784;
}

.badge.text {
  background: var(--transformed-soft);
  color: var(--transformed);
}

.badge.date,
.badge.datetime,
.badge.time {
  background: var(--success-soft);
  color: var(--success);
}

.badge.boolean {
  background: var(--accent-soft);
  color: var(--accent);
}

.card-foot {
  padding: 7px 14px;
  border-top: 1px solid var(--border);
  color: var(--ink-faint);
  font-size: 11px;
}

.overlay {
  position: absolute;
  z-index: 10000;
  cursor: default;
}

.title {
  top: 24px;
  left: 36px;
  display: flex;
  align-items: baseline;
  gap: 14px;
  padding: 4px 10px 4px 0;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--bg) 85%, transparent);
}

.title h2 {
  font-size: 30px;
}

.title p {
  margin: 0;
  color: var(--ink-muted);
}

.top-actions {
  display: flex;
  gap: 8px;
}

.new-table {
  border-color: var(--transformed);
  color: var(--transformed);
}

.new-table:hover:not(:disabled) {
  border-color: var(--transformed);
  background: var(--transformed-soft);
}

/* Transformed tables (built by SQL) use purple; loaded tables use the accent. */
.table-card.transformed .card-head {
  border-top-color: var(--transformed);
}

.card-error {
  margin: 0;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.refresh-area {
  top: 28px;
  right: 24px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  max-width: 420px;
}

.refresh {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  font-weight: 600;
  white-space: nowrap;
}

.refresh:hover:not(:disabled) {
  border-color: var(--ink-faint);
}

.refresh:disabled {
  color: var(--ink-muted);
}

.spinning {
  animation: spin 1s linear infinite;
}

.refresh-status,
.refresh-result {
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.refresh-status {
  background: var(--surface);
  color: var(--ink-muted);
  box-shadow: var(--shadow-sm);
}

.refresh-result {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  background: var(--success-soft);
  color: var(--success);
}

.refresh-result.failed {
  background: var(--danger-soft);
  color: var(--danger);
}

.dismiss {
  padding: 0 2px;
  border: none;
  background: none;
  color: inherit;
  font-size: 16px;
  line-height: 1;
}

.toolbar {
  right: 20px;
  bottom: 20px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-md);
}

.toolbar button {
  min-width: 32px;
  height: 30px;
  padding: 0 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  font-weight: 600;
}

.toolbar button:hover {
  background: var(--surface-muted);
}

.zoom-level {
  min-width: 44px;
  color: var(--ink-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.sep {
  width: 1px;
  height: 18px;
  margin: 0 4px;
  background: var(--border);
}

.hint {
  bottom: 26px;
  left: 36px;
  margin: 0;
  color: var(--ink-faint);
  font-size: 12px;
}

.error {
  position: absolute;
  top: 80px;
  left: 36px;
  z-index: 10001;
}

.centered {
  margin: auto;
}

.status {
  color: var(--ink-muted);
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-width: 380px;
  text-align: center;
}

.empty h3 {
  font-size: 22px;
}

.empty p {
  margin: 0;
  color: var(--ink-muted);
}

.add-data {
  margin-top: 6px;
}
</style>
