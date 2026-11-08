<script setup lang="ts">
import type { TablePreview } from '../../shared/types';

defineProps<{ preview: TablePreview }>();

const format = (value: unknown) =>
  value === null || value === undefined
    ? ''
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
</script>

<template>
  <div class="grid">
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th v-for="c in preview.columns" :key="c.name">
              {{ c.name }}
              <small>{{ c.type }}</small>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in preview.rows" :key="i">
            <td
              v-for="(value, j) in row"
              :key="j"
              :class="{ empty: value === null }"
            >
              {{ format(value) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="preview.row_count > preview.rows.length" class="more">
      Showing the first {{ preview.rows.length.toLocaleString() }} of
      {{ preview.row_count.toLocaleString() }} rows.
    </p>
  </div>
</template>

<style scoped>
.grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}

.table-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

table {
  border-collapse: collapse;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

th,
td {
  max-width: 320px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
  overflow: hidden;
  white-space: nowrap;
  text-align: left;
  text-overflow: ellipsis;
}

th {
  position: sticky;
  top: 0;
  background: var(--surface-muted);
  font-weight: 600;
}

th small {
  display: block;
  color: var(--ink-faint);
  font-weight: 500;
  font-size: 11px;
}

td.empty::after {
  content: 'null';
  color: var(--ink-faint);
  font-style: italic;
}

tbody tr:hover {
  background: var(--bg);
}

.more {
  margin: 0;
  color: var(--ink-muted);
  font-size: 13px;
}
</style>
