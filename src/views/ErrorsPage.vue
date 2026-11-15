<script setup lang="ts">
// The project's errors, each with "Fix with assistant", which goes back to the project and
// asks the assistant to find out why and fix it (ProjectWorkspace.vue sends the request).
import { errorLabel, errorSummary } from '../shared/project-errors';
import type { ProjectError } from '../shared/types';

defineProps<{ errors: ProjectError[] }>();
defineEmits<{ back: []; fix: [error: ProjectError] }>();
</script>

<template>
  <div class="errors-page">
    <button class="btn-link back" @click="$emit('back')">
      ← Back to the project
    </button>
    <h2>Errors</h2>

    <template v-if="errors.length">
      <p class="intro">
        These parts of the project failed the last time they ran.
        <strong>Fix with assistant</strong> asks the assistant to find out why
        and fix it, and takes you back to the chat to follow along.
      </p>
      <ul class="list">
        <li
          v-for="(e, i) in errors"
          :key="`${e.kind}:${e.name}:${i}`"
          class="item"
        >
          <div class="item-text">
            <span class="label">{{ errorLabel(e) }}</span>
            <h3>{{ errorSummary(e) }}</h3>
            <pre class="message">{{ e.message }}</pre>
          </div>
          <button class="btn-primary fix" @click="$emit('fix', e)">
            Fix with assistant
          </button>
        </li>
      </ul>
    </template>
    <p v-else class="box-notice" role="status">
      No errors. Everything loaded and built the last time it ran.
    </p>
  </div>
</template>

<style scoped>
.errors-page {
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: 100%;
  max-width: 820px;
  margin: 0 auto;
  padding: 32px 36px 48px;
}

.back {
  align-self: flex-start;
  text-decoration: none;
}

.back:hover {
  color: var(--ink);
}

h2 {
  font-size: 30px;
}

.intro {
  margin: 0;
  color: var(--ink-muted);
}

.list {
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  list-style: none;
}

.item {
  display: flex;
  align-items: flex-start;
  gap: 20px;
  padding: 18px 22px;
}

.item + .item {
  border-top: 1px solid var(--border);
}

.item-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.label {
  color: var(--danger);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.item h3 {
  font-size: 17px;
  overflow-wrap: anywhere;
}

.message {
  max-height: 160px;
  margin: 4px 0 0;
  padding: 8px 10px;
  overflow: auto;
  border-left: 2px solid var(--danger);
  background: var(--danger-soft);
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.fix {
  flex: none;
  white-space: nowrap;
}
</style>
