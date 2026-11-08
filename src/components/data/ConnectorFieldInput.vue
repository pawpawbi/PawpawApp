<script setup lang="ts">
import { computed } from 'vue';
import { plain } from '../../plain';
import type { ConnectorField } from '../../shared/types';

const props = defineProps<{
  field: ConnectorField;
  /** A secret already saved on this computer: leaving the field empty keeps it. */
  saved?: boolean;
}>();
const model = defineModel<unknown>();

const id = computed(() => `field-${props.field.key}`);
const paths = computed(() =>
  Array.isArray(model.value)
    ? (model.value as string[])
    : model.value
      ? [String(model.value)]
      : [],
);
const placeholder = computed(() =>
  props.saved
    ? 'Saved on this computer. Leave blank to keep it.'
    : props.field.placeholder,
);

async function browse() {
  const kind = props.field.type as 'file' | 'files' | 'folder';
  const chosen = await window.api.data.pickPaths(
    kind,
    plain(props.field.fileFilters),
  );
  if (chosen.length === 0) return;
  model.value = kind === 'files' ? chosen : chosen[0];
}

function removePath(path: string) {
  model.value = paths.value.filter((p) => p !== path);
}
</script>

<template>
  <div class="field" :class="{ checkbox: field.type === 'checkbox' }">
    <template v-if="field.type === 'checkbox'">
      <label :for="id" class="check">
        <input :id="id" v-model="model" type="checkbox" />
        {{ field.label }}
      </label>
    </template>

    <template v-else>
      <label :for="id">
        {{ field.label }}
        <span v-if="field.required" class="required" aria-hidden="true">*</span>
        <span
          v-if="field.secret"
          class="secret-badge"
          title="Stored encrypted on this computer, never in the project file"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          Private
        </span>
      </label>

      <select v-if="field.type === 'select'" :id="id" v-model="model">
        <option
          v-for="option in field.options"
          :key="option.value"
          :value="option.value"
        >
          {{ option.label }}
        </option>
      </select>

      <textarea
        v-else-if="field.type === 'textarea'"
        :id="id"
        v-model="model as string"
        :class="{ mono: field.secret }"
        :placeholder="placeholder"
        rows="4"
        spellcheck="false"
      ></textarea>

      <div
        v-else-if="
          field.type === 'file' ||
          field.type === 'files' ||
          field.type === 'folder'
        "
        class="paths"
      >
        <ul v-if="paths.length" class="path-list">
          <li v-for="path in paths" :key="path">
            <span :title="path">{{ path }}</span>
            <button
              type="button"
              class="btn-link remove"
              @click="removePath(path)"
            >
              Remove
            </button>
          </li>
        </ul>
        <button :id="id" type="button" class="btn-ghost" @click="browse">
          {{
            paths.length && field.type === 'files'
              ? 'Add more…'
              : field.type === 'folder'
                ? 'Choose folder…'
                : 'Choose file…'
          }}
        </button>
      </div>

      <input
        v-else
        :id="id"
        v-model="model"
        :type="
          field.type === 'password'
            ? 'password'
            : field.type === 'number'
              ? 'number'
              : field.type === 'date'
                ? 'date'
                : 'text'
        "
        :placeholder="placeholder"
        :autocomplete="field.secret ? 'off' : undefined"
        spellcheck="false"
      />
    </template>

    <p v-if="field.help" class="help">{{ field.help }}</p>
  </div>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 13px;
}

.required {
  color: var(--accent);
}

.secret-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  color: var(--ink-faint);
  font-size: 11px;
  font-weight: 500;
}

.secret-badge svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
}

input:not([type='checkbox']),
select,
textarea {
  width: 100%;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  font: inherit;
  transition: border-color 0.15s;
}

input:focus,
select:focus,
textarea:focus {
  border-color: var(--ink-faint);
  outline: none;
}

textarea {
  resize: vertical;
}

textarea.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}

.check {
  font-weight: 500;
  cursor: pointer;
}

.check input {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
}

.help {
  margin: 0;
  color: var(--ink-muted);
  font-size: 12px;
}

.paths {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}

.path-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
}

.path-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: var(--surface-muted);
  font-size: 13px;
}

.path-list span {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}

.remove {
  font-size: 12px;
}
</style>
